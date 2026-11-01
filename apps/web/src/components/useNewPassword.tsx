import { PasswordInput } from "@mantine/core";
import { useState } from "react";

/**
 * A new password, typed twice as there's no way to reset a mistyped one from the app. `matches` is for holding back
 * the form; the mismatch only shows once what's typed second has gone wrong, not while it's on its way.
 */
export function useNewPassword({ autoFocus = false }: { autoFocus?: boolean } = {}) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const fields = (
    <>
      <PasswordInput
        label="Password"
        description="At least 12 characters"
        autoComplete="new-password"
        required
        autoFocus={autoFocus}
        minLength={12}
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
      />
      <PasswordInput
        label="Confirm password"
        autoComplete="new-password"
        required
        value={again}
        error={password.startsWith(again) ? undefined : "The passwords don't match"}
        onChange={(e) => setAgain(e.currentTarget.value)}
      />
    </>
  );
  return { password, matches: password === again, fields };
}
