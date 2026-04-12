import { SecuritySettings } from '@prisma/client';
import { prisma } from '../config/database';

let cache: SecuritySettings | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

export async function loadSecuritySettings(): Promise<SecuritySettings> {
  if (cache && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cache;
  }
  cache = await prisma.securitySettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
  cacheTime = Date.now();
  return cache;
}

export function invalidateSecuritySettingsCache(): void {
  cache = null;
  cacheTime = 0;
}
