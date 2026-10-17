export function renderAuthUi(button, account, state, githubLogin = "") {
  const signedIn = state === "signed-in";
  const busy = state === "signing-in" || state === "signing-out";

  button.textContent = signedIn ? "Sign out" : "Sign in with GitHub";
  button.dataset.action = signedIn ? "sign-out" : "sign-in";
  button.disabled = busy;
  account.hidden = !signedIn;
  account.textContent = signedIn ? `Signed in as @${githubLogin}` : "";
}
