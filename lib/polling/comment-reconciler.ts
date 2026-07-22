/**
 * Comment reconciliation (polling safety net).
 *
 * Instagram webhooks are best-effort and never fire for a large class of
 * comments — collapsed "load more" comments, comments from non-followers or
 * low-signal accounts, anything Instagram filters. Those comments are otherwise
 * invisible to the system: never logged, never replied to, never DM'd.
 *
 * This sweep is the source of truth for completeness. It runs on an interval in
 * the worker process (Vercel's free crons only fire once a day, so this cannot
 * live in an API cron). For every account with an active campaign it pulls the
 * relevant media, reads every comment with full pagination, and enqueues any it
 * has not seen before. Dedup is shared with the webhook path via the
 * ProcessedComment store and the identical BullMQ job id, so nothing is handled
 * twice. The actual reply + DM work (and its rate limiting) happens in the
 * worker's processComment, exactly as for webhook-delivered comments.
 *
 * Known limitation, handled not fixed: comments removed by Instagram's Hidden
 * Words / spam filter may not be returned by the Graph API at all. When that is
 * suspected it is noted in the sweep log; the account owner has to disable that
 * filter in Instagram settings to widen the API results.
 */

import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import {
  getAllMediaComments,
  getUserMedia,
  MetaApiError,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

// How many recent posts to scan for accounts running an "any post" campaign.
const RECENT_MEDIA_LIMIT = 25;

interface SweepAccount {
  id: string;
  instagramId: string;
  username: string;
  accessToken: string;
  workspaceId: string;
}

interface SweepResult {
  username: string;
  mediaPolled: number;
  commentsSeen: number;
  newEnqueued: number;
  alreadyProcessed: number;
  selfSkipped: number;
  errors: string[];
}

function errMessage(error: unknown): string {
  if (error instanceof MetaApiError) return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** One full reconciliation pass across every account with an active campaign. */
export async function reconcileComments(): Promise<void> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { automations: { some: { isActive: true } } },
    select: {
      id: true,
      instagramId: true,
      username: true,
      accessToken: true,
      workspaceId: true,
    },
  });

  for (const account of accounts) {
    const result = await sweepAccount(account).catch(
      (error): SweepResult => ({
        username: account.username,
        mediaPolled: 0,
        commentsSeen: 0,
        newEnqueued: 0,
        alreadyProcessed: 0,
        selfSkipped: 0,
        errors: [errMessage(error)],
      })
    );
    await recordSweep(account, result);
  }
}

async function sweepAccount(account: SweepAccount): Promise<SweepResult> {
  const result: SweepResult = {
    username: account.username,
    mediaPolled: 0,
    commentsSeen: 0,
    newEnqueued: 0,
    alreadyProcessed: 0,
    selfSkipped: 0,
    errors: [],
  };

  let accessToken: string;
  try {
    accessToken = decryptToken(account.accessToken);
  } catch {
    result.errors.push("Failed to decrypt access token");
    return result;
  }

  const automations = await prisma.automation.findMany({
    where: { instagramAccountId: account.id, isActive: true },
    select: { postId: true, matchAnyPost: true },
  });
  if (automations.length === 0) return result;

  // Which media to scan: every post a campaign targets, plus the recent feed if
  // any campaign matches "any post".
  const mediaIds = new Set<string>();
  for (const a of automations) if (a.postId) mediaIds.add(a.postId);

  if (automations.some((a) => a.matchAnyPost)) {
    try {
      const media = await getUserMedia(accessToken, RECENT_MEDIA_LIMIT);
      for (const m of media) mediaIds.add(m.id);
    } catch (error) {
      result.errors.push(`Media list: ${errMessage(error)}`);
    }
  }

  const queue = getDMQueue();

  for (const mediaId of mediaIds) {
    let comments;
    try {
      comments = await getAllMediaComments(accessToken, mediaId);
    } catch (error) {
      result.errors.push(`Comments for ${mediaId}: ${errMessage(error)}`);
      continue;
    }

    result.mediaPolled += 1;
    result.commentsSeen += comments.length;

    // Never act on the account's own comments — Meta rejects DMing yourself.
    const actionable = comments.filter(
      (c) => c.from?.id && c.from.id !== account.instagramId
    );
    result.selfSkipped += comments.length - actionable.length;
    if (actionable.length === 0) continue;

    // Skip anything already in the shared dedup store (webhook- or poll-caught).
    const ids = actionable.map((c) => c.id);
    const seen = await prisma.processedComment.findMany({
      where: { commentId: { in: ids } },
      select: { commentId: true },
    });
    const seenSet = new Set(seen.map((s) => s.commentId));
    result.alreadyProcessed += seenSet.size;

    const fresh = actionable.filter((c) => !seenSet.has(c.id));
    if (fresh.length === 0) continue;

    for (const c of fresh) {
      // Same job id as the webhook path, so a comment racing in on both is
      // deduped by BullMQ rather than processed twice.
      await queue.add(
        "process-comment",
        {
          instagramAccountId: account.instagramId,
          commentId: c.id,
          commentText: c.text ?? "",
          commenterId: c.from.id,
          commenterName: c.from.username,
          mediaId,
          source: "POLLING",
        },
        { jobId: `comment_${account.instagramId}_${c.id}` }
      );
      result.newEnqueued += 1;
    }

    // Mark them seen immediately (the jobs are durably queued), so the next
    // sweep skips them even before the worker gets to them.
    await prisma.processedComment
      .createMany({
        data: fresh.map((c) => ({
          commentId: c.id,
          instagramAccountId: account.instagramId,
          source: "POLLING",
        })),
        skipDuplicates: true,
      })
      .catch(() => {});
  }

  return result;
}

async function recordSweep(
  account: SweepAccount,
  result: SweepResult
): Promise<void> {
  // Only log when something happened or something went wrong; a quiet sweep
  // over an idle account should not spam the operational log.
  if (
    result.newEnqueued === 0 &&
    result.errors.length === 0 &&
    result.mediaPolled === 0
  ) {
    return;
  }

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: account.workspaceId,
        source: "SYSTEM",
        level: result.errors.length > 0 ? "WARNING" : "INFO",
        message: `Comment sweep @${result.username}: ${result.newEnqueued} new, ${result.alreadyProcessed} already seen, across ${result.mediaPolled} media (${result.commentsSeen} comments)`,
        payload: {
          ...result,
          note:
            "Comments hidden by Instagram's Hidden Words / spam filter may not appear in the API. Disable that filter on the account to widen results.",
        },
      },
    })
    .catch(() => {});
}
