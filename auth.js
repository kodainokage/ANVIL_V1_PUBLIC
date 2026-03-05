'use strict';
/**
 * ANVIL Authentication Module — STUB FOR PUBLIC REPOSITORY
 *
 * This file is a placeholder. The real auth.js is a private module that
 * handles session management, password hashing (scrypt), OAuth (Google/Discord),
 * and magic link authentication.
 *
 * TO DEPLOY: Replace this file with your real auth.js implementation.
 * See README.md for the full interface this module must export.
 *
 * Required exports:
 *   initAuthTables(db)
 *   hashPassword(password) → Promise<{hash, salt}>
 *   verifyPassword(password, hash, salt) → Promise<boolean>
 *   dummyHash() → Promise<void>
 *   createSession(userId, req) → sessionId
 *   destroySession(sessionId)
 *   getSessionUser(sessionId) → user | null
 *   cleanExpiredSessions()
 *   parseCookies(header) → object
 *   serializeSessionCookie(id) → string
 *   clearSessionCookie() → string
 *   generateState(provider, redirectTo) → state
 *   verifyState(state) → {provider, redirect_to} | null
 *   generateMagicToken(email) → token
 *   verifyMagicToken(token) → {email} | null
 *   getMagicLinkUrl(token, origin) → url
 *   sendMagicLinkEmail(email, url) → 'sent' | 'console'
 *   isMagicLinkRateLimited(email) → boolean
 *   findOrCreateMagicUser(email) → user
 *   findOrCreateOAuthUser(provider, profile) → user
 *   oauthFetchToken(provider, code, redirectUri) → {status, data}
 *   oauthFetchProfile(provider, accessToken) → {status, data}
 *   isGoogleConfigured() → boolean
 *   isDiscordConfigured() → boolean
 *   isValidRedirect(path) → boolean
 *   getProvidersConfigured() → object
 *   stmts → prepared statement map
 */

// Stub: crashes loudly at startup so operators know they need the real module.
throw new Error(
  '[ANVIL] auth.js is not implemented. ' +
  'Replace /auth.js with your authentication module before starting the server. ' +
  'See the README for the required interface.'
);
