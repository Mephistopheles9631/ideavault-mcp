import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const TOKEN = process.env.AUTH_TOKEN;

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const vaultHeader = req.header("x-vault-token");
  if (vaultHeader) return vaultHeader;
  const queryToken = req.query.token;
  if (typeof queryToken === "string") return queryToken;
  return undefined;
}

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!TOKEN) {
    res.status(500).json({ error: "server misconfigured: AUTH_TOKEN not set" });
    return;
  }
  const provided = extractToken(req);
  if (!provided || !timingSafeEqualStr(provided, TOKEN)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "https://claude.ai")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function validateOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header("origin");
  if (!origin) {
    next();
    return;
  }
  if (ALLOWED_ORIGINS.includes(origin)) {
    next();
    return;
  }
  res.status(403).json({ error: "origin not allowed" });
}
