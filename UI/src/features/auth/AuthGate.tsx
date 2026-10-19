import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Field } from "../../components/common/Field";
import { api } from "../../services/apiClient";
import type { AuthenticatedUser } from "../../types";

export function AuthGate({
  onLogin,
  expired = false,
}: {
  onLogin: (user: AuthenticatedUser) => void;
  expired?: boolean;
}) {
  const [flow, setFlow] = useState(() => window.location.hash.slice(1)),
    [email, setEmail] = useState(""),
    [invitationEmail, setInvitationEmail] = useState(""),
    [invitationChecking, setInvitationChecking] = useState(false),
    [password, setPassword] = useState(""),
    [error, setError] = useState(
      expired ? "Your session expired or was revoked. Sign in again to continue." : "",
    ),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const update = () => setFlow(window.location.hash.slice(1));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const [route, query = ""] = flow.split("?"),
    params = new URLSearchParams(query),
    token = params.get("token") || "";
  const resetRequest = route === "reset-password" && !token,
    resetComplete = route === "reset-password" && Boolean(token),
    invitation = route === "accept-invitation";
  useEffect(() => {
    if (!invitation) {
      setInvitationEmail("");
      return;
    }
    if (!token) {
      setError("This invitation link is missing its token. Ask an Admin for a new one.");
      return;
    }

    let active = true;
    setInvitationChecking(true);
    api<{ email: string }>(`/auth/invitation?token=${encodeURIComponent(token)}`)
      .then((result) => {
        if (active) setInvitationEmail(result.email);
      })
      .catch((requestError: Error) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setInvitationChecking(false);
      });

    return () => {
      active = false;
    };
  }, [invitation, token]);
  const title = invitation
    ? "Accept your invitation"
    : resetComplete
      ? "Choose a new password"
      : resetRequest
        ? "Reset your password"
        : "Sign in to Royal Barks";
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      if (invitation || resetComplete) {
        if (password.length < 12) throw Error("Use a password with at least 12 characters.");
        await api(invitation ? "/auth/accept-invitation" : "/auth/password-reset/complete", {
          method: "POST",
          body: JSON.stringify({ token, password }),
        });
        setMessage(
          invitation
            ? "Invitation accepted. Your email is verified; sign in to continue."
            : "Password updated. Sign in with your new password.",
        );
        window.history.replaceState(null, "", window.location.pathname + "#login");
        setFlow("login");
        setPassword("");
        return;
      }
      if (resetRequest) {
        const result = await api<{ message: string }>("/auth/password-reset/request", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        setMessage(result.message);
        return;
      }
      const result = await api<{ user: AuthenticatedUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onLogin(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-logo">RB</div>
        <div className="eyebrow">ROYAL BARKS · SECURE ACCESS</div>
        <h1>{title}</h1>
        <p>
          {invitation
            ? "Use a strong password to activate the invited account."
            : resetComplete
              ? "Password reset links expire after 30 minutes."
              : resetRequest
                ? "We’ll send instructions if an active account matches this address."
                : "Accounts are invite-only. Contact an authorized administrator if you need access."}
        </p>
        {!invitation && !resetComplete && (
          <Field label="EMAIL ADDRESS">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </Field>
        )}
        {invitation && (
          <div className="notice">
            {invitationChecking
              ? "Checking invitation…"
              : invitationEmail
                ? `Password will be set for ${invitationEmail}.`
                : "The invitation could not be verified."}
          </div>
        )}
        {!resetRequest && !resetComplete && !invitation && (
          <Field label="PASSWORD">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
        )}
        {(invitation || resetComplete) && (
          <Field label="NEW PASSWORD · 12 CHARACTERS MINIMUM">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
            />
          </Field>
        )}
        {error && <div className="form-error">{error}</div>}
        {message && <div className="notice">{message}</div>}
        <button
          className="btn primary auth-submit"
          disabled={busy || (invitation && (invitationChecking || !invitationEmail))}
        >
          {busy
            ? "Please wait…"
            : invitation
              ? invitationChecking
                ? "Checking invitation…"
                : "Accept invitation"
              : resetComplete
                ? "Update password"
                : resetRequest
                  ? "Send reset instructions"
                  : "Sign in"}
        </button>
        {!invitation && !resetComplete && (
          <button
            type="button"
            className="link-button auth-link"
            onClick={() => {
              window.location.hash = resetRequest ? "login" : "reset-password";
              setError("");
              setMessage("");
            }}
          >
            {resetRequest ? "Back to sign in" : "Forgot password?"}
          </button>
        )}
      </form>
    </div>
  );
}
