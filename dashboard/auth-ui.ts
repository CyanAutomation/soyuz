export type AuthUiState = "signed-out" | "signing-in" | "signed-in" | "signing-out";

interface AuthButton {
  textContent: string | null;
  disabled: boolean;
  dataset: DOMStringMap;
}

interface AccountLabel {
  textContent: string | null;
  hidden: HTMLElement["hidden"];
}

export function renderAuthUi(
  button: AuthButton,
  account: AccountLabel,
  state: AuthUiState,
  githubLogin = "",
): void {
  const signedIn = state === "signed-in";
  const busy = state === "signing-in" || state === "signing-out";

  button.textContent = signedIn ? "Sign out" : "Sign in with GitHub";
  button.dataset.action = signedIn ? "sign-out" : "sign-in";
  button.disabled = busy;
  account.hidden = !signedIn;
  account.textContent = signedIn ? `Signed in as @${githubLogin}` : "";
}
