import type { Request, Response, NextFunction } from "express";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60; // generous for one person's real usage, blunt for hammering/brute force

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, bucket] of buckets) {
    if (bucket.windowStart < cutoff) buckets.delete(ip);
  }
}, WINDOW_MS).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now });
    next();
    return;
  }
  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS) {
    res.status(429).json({ error: "rate limit exceeded, try again shortly" });
    return;
  }
  next();
}
