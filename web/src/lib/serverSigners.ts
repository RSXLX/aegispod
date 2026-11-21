import * as fs from "node:fs";
import * as path from "node:path";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

function getEnvVar(name: string): string {
  if (process.env[name]) return process.env[name] as string;
  const candidates = [
    path.resolve(process.cwd(), "../contracts/.env"),
    path.resolve(process.cwd(), "contracts/.env"),
    path.resolve(process.cwd(), ".env.local"),
  ];
  for (const p of candidates) {
    const parsed = parseEnvFile(p);
    if (parsed[name]) return parsed[name];
  }
  throw new Error(`Missing required server env var: ${name}`);
}

export function getDemoSigners(): {
  owner: PrivateKeyAccount;
  guardian: PrivateKeyAccount;
} {
  const ownerKey = getEnvVar("OWNER_PRIVATE_KEY") as `0x${string}`;
  const guardianKey = getEnvVar("GUARDIAN_PRIVATE_KEY") as `0x${string}`;
  return {
    owner: privateKeyToAccount(ownerKey),
    guardian: privateKeyToAccount(guardianKey),
  };
}
