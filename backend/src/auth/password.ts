import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id, per spec A-11 / plan.md Task 7. Used here by the seed script to set
 * the admin's initial password; Task 7 reuses it for login and reset.
 */
export function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword);
}

export function verifyPassword(passwordHash: string, plainPassword: string): Promise<boolean> {
  return verify(passwordHash, plainPassword);
}
