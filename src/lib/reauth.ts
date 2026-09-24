// Signing in again when a project's sign-in has expired. A command whose
// token can't be refreshed fails with `SIGN_IN_REQUIRED:<project id>:<reason>`
// (auth::SIGN_IN_REQUIRED); `withReauth` then waits while the app asks the
// user to sign in (ReauthModal) and runs the command once more.
import { create } from "zustand";

const PREFIX = "SIGN_IN_REQUIRED:";

export interface ReauthRequest {
  projectId: string;
  /** Entra's reason, e.g. "AADSTS700082: The refresh token has expired due to inactivity…". */
  reason: string;
}

interface ReauthStore {
  /** Shown by ReauthModal while set. */
  request: ReauthRequest | null;
  /** The dialog's answer: true once signed in again, false when the user gives up. */
  settle: (signedIn: boolean) => void;
}

// One question for all the commands that fail together.
let answer: Promise<boolean> | null = null;
let resolveAnswer: ((signedIn: boolean) => void) | null = null;

export const useReauth = create<ReauthStore>((set) => ({
  request: null,
  settle: (signedIn) => {
    resolveAnswer?.(signedIn);
    answer = null;
    resolveAnswer = null;
    set({ request: null });
  },
}));

export function parseSignInRequired(e: unknown): ReauthRequest | null {
  const s = String(e);
  if (!s.startsWith(PREFIX)) return null;
  const rest = s.slice(PREFIX.length);
  const at = rest.indexOf(":");
  return at < 0 ? { projectId: rest, reason: "" } : { projectId: rest.slice(0, at), reason: rest.slice(at + 1) };
}

function askToSignIn(request: ReauthRequest): Promise<boolean> {
  if (!answer) {
    answer = new Promise((resolve) => (resolveAnswer = resolve));
    useReauth.setState({ request });
  }
  return answer;
}

/** Runs `call`; when it needs a new sign-in, asks for one and runs it once more. */
export async function withReauth<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const request = parseSignInRequired(e);
    if (!request) throw e;
    if (await askToSignIn(request)) {
      try {
        return await call();
      } catch (again) {
        throw parseSignInRequired(again) ? signInMessage(request) : again;
      }
    }
    throw signInMessage(request);
  }
}

/** What a command that still has no token shows. */
function signInMessage(request: ReauthRequest): string {
  return `Sign in again to continue.${request.reason ? ` ${request.reason}` : ""}`;
}
