import crypto from 'node:crypto';

export class PairingTokenService {
  generate(): string {
    return crypto.randomBytes(12).toString('hex');
  }

  matches(expectedToken: string | null, candidateToken: string | null): boolean {
    if (!expectedToken) {
      return true;
    }

    if (!candidateToken) {
      return false;
    }

    const normalizedExpected = expectedToken.trim();
    const normalizedCandidate = candidateToken.trim();

    if (!normalizedExpected || !normalizedCandidate) {
      return false;
    }

    if (normalizedExpected.length !== normalizedCandidate.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(normalizedExpected),
      Buffer.from(normalizedCandidate),
    );
  }
}
