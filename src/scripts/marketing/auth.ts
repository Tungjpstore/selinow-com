import { createSystemTranslator } from "../../lib/i18n";

const lang = document.documentElement.lang || "vi-VN";
const t = createSystemTranslator(lang);

type AuthApiResponse = {
  challengeToken?: string;
  code?: string;
  cooldownSeconds?: number;
  debugOtp?: string;
  error?: string;
  expiresAt?: string;
  issues?: string[];
  message?: string;
  ok?: boolean;
  requestId?: string;
  requireOtp?: boolean;
  resetToken?: string;
  twoFactorRequired?: boolean;
  user?: {
    displayName: string;
    email: string;
    sessionId: string;
    userId: string;
  };
};

function setStatus(statusEl: HTMLElement | null, tone: "error" | "pending" | "success" | "", message: string): void {
  if (!statusEl) return;
  if (tone === "") {
    statusEl.removeAttribute("data-tone");
  } else {
    statusEl.dataset.tone = tone;
  }
  statusEl.textContent = message;
}

function setBusy(buttonEl: HTMLButtonElement | null, busy: boolean, busyText?: string, defaultText?: string): void {
  if (!buttonEl) return;
  buttonEl.disabled = busy;
  buttonEl.setAttribute("aria-busy", String(busy));
  const labelEl = buttonEl.querySelector<HTMLElement>("[data-submit-label]");
  if (labelEl) {
    labelEl.textContent = busy ? (busyText ?? t("auth.login.submitting")) : (defaultText ?? t("auth.login.submit"));
  }
}

// ----------------------------------------------------
// Password Visibility Toggles
// ----------------------------------------------------
document.querySelectorAll<HTMLButtonElement>("[data-toggle-password]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const parent = btn.closest(".input-control");
    if (!parent) return;
    const input = parent.querySelector<HTMLInputElement>("input[type='password'], input[type='text']");
    if (!input) return;

    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";

    btn.innerHTML = isPassword
      ? `<svg class="icon-eye-off" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" x2="22" y1="2" y2="22" />
        </svg>`
      : `<svg class="icon-eye" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>`;
  });
});

// ----------------------------------------------------
// Password Strength Meter Helper
// ----------------------------------------------------
function bindStrengthMeter(inputEl: HTMLInputElement | null, containerEl: HTMLElement | null, fillEl: HTMLElement | null, labelEl: HTMLElement | null): void {
  if (!inputEl || !containerEl || !fillEl || !labelEl) return;
  inputEl.addEventListener("input", () => {
    const val = inputEl.value;
    if (!val) {
      containerEl.hidden = true;
      return;
    }
    containerEl.hidden = false;

    let score = 0;
    if (val.length >= 8) score += 1;
    if (/[A-Z]/u.test(val)) score += 1;
    if (/[0-9]/u.test(val)) score += 1;
    if (/[^A-Za-z0-9]/u.test(val)) score += 1;

    if (score <= 1) {
      fillEl.style.width = "25%";
      fillEl.style.backgroundColor = "#EF4444";
      labelEl.textContent = "Mật khẩu yếu";
      labelEl.style.color = "#EF4444";
    } else if (score === 2) {
      fillEl.style.width = "50%";
      fillEl.style.backgroundColor = "#F59E0B";
      labelEl.textContent = "Mật khẩu trung bình";
      labelEl.style.color = "#F59E0B";
    } else if (score === 3) {
      fillEl.style.width = "75%";
      fillEl.style.backgroundColor = "#3B82F6";
      labelEl.textContent = "Mật khẩu khá";
      labelEl.style.color = "#3B82F6";
    } else {
      fillEl.style.width = "100%";
      fillEl.style.backgroundColor = "#10B981";
      labelEl.textContent = "Mật khẩu rất mạnh";
      labelEl.style.color = "#10B981";
    }
  });
}

bindStrengthMeter(
  document.querySelector<HTMLInputElement>("[data-register-password]"),
  document.querySelector<HTMLElement>("[data-strength-meter]"),
  document.querySelector<HTMLElement>("[data-strength-fill]"),
  document.querySelector<HTMLElement>("[data-strength-label]"),
);

bindStrengthMeter(
  document.querySelector<HTMLInputElement>("[data-reset-new-password]"),
  document.querySelector<HTMLElement>("[data-reset-strength-meter]"),
  document.querySelector<HTMLElement>("[data-reset-strength-fill]"),
  document.querySelector<HTMLElement>("[data-reset-strength-label]"),
);

// ----------------------------------------------------
// OTP Inputs Management (6 separate boxes)
// ----------------------------------------------------
export function setupOtpInputs(container: HTMLElement, onComplete?: (otp: string) => void): { getOtp: () => string; reset: () => void } {
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("input[data-otp-digit]"));

  inputs.forEach((input, index) => {
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      const val = target.value.replace(/\D/gu, "");
      target.value = val.slice(-1); // only keep last digit

      if (target.value && index < inputs.length - 1) {
        inputs[index + 1]?.focus();
      }

      const fullOtp = inputs.map((i) => i.value).join("");
      if (fullOtp.length === inputs.length && onComplete) {
        onComplete(fullOtp);
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !input.value && index > 0) {
        inputs[index - 1]?.focus();
      }
    });

    input.addEventListener("paste", (e) => {
      e.preventDefault();
      const pasted = e.clipboardData?.getData("text").replace(/\D/gu, "") ?? "";
      if (!pasted) return;

      inputs.forEach((inp, i) => {
        inp.value = pasted[i] ?? "";
      });

      const nextFocus = Math.min(pasted.length, inputs.length - 1);
      const targetInput = inputs[nextFocus];
      if (targetInput) {
        targetInput.focus();
      }

      const fullOtp = inputs.map((i) => i.value).join("");
      if (fullOtp.length === inputs.length && onComplete) {
        onComplete(fullOtp);
      }
    });
  });

  return {
    getOtp: () => inputs.map((i) => i.value).join(""),
    reset: () => {
      inputs.forEach((i) => {
        i.value = "";
      });
      inputs[0]?.focus();
    },
  };
}

// ----------------------------------------------------
// Cooldown Timer
// ----------------------------------------------------
export function startCooldownTimer(buttonEl: HTMLButtonElement, seconds: number, onExpire?: () => void): () => void {
  let remaining = seconds;
  buttonEl.disabled = true;

  const updateLabel = () => {
    buttonEl.textContent = t("auth.otp.cooldown", { seconds: String(remaining) });
  };

  updateLabel();

  const intervalId = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(intervalId);
      buttonEl.disabled = false;
      buttonEl.textContent = t("auth.otp.resend");
      if (onExpire) onExpire();
    } else {
      updateLabel();
    }
  }, 1000);

  return () => {
    clearInterval(intervalId);
  };
}

// ----------------------------------------------------
// Setup Login Page
// ----------------------------------------------------
const loginForm = document.querySelector<HTMLFormElement>("[data-login-form]");
if (loginForm) {
  const emailInput = loginForm.querySelector<HTMLInputElement>("[data-login-email]");
  const passwordInput = loginForm.querySelector<HTMLInputElement>("[data-login-password]");
  const rememberCheckbox = loginForm.querySelector<HTMLInputElement>("[data-login-remember]");
  const submitBtn = loginForm.querySelector<HTMLButtonElement>("[data-login-submit]");
  const statusEl = document.querySelector<HTMLElement>("[data-login-status]");

  const twoFactorPanel = document.querySelector<HTMLElement>("[data-login-2fa]");
  const twoFactorOtpInput = document.querySelector<HTMLInputElement>("[data-login-2fa-otp]");
  const twoFactorEmailDisplay = document.querySelector<HTMLElement>("[data-login-2fa-email]");
  const twoFactorSubmitBtn = document.querySelector<HTMLButtonElement>("[data-login-2fa-submit]");
  const twoFactorResendBtn = document.querySelector<HTMLButtonElement>("[data-login-2fa-resend]");
  const twoFactorBackBtn = document.querySelector<HTMLButtonElement>("[data-login-2fa-back]");
  const twoFactorStatusEl = document.querySelector<HTMLElement>("[data-login-2fa-status]");

  // The challenge token lives in this closure only; it is never persisted.
  let twoFactorChallengeToken = "";
  let twoFactorEmail = "";

  const showTwoFactorStep = (cooldownSeconds: number | undefined): void => {
    loginForm.hidden = true;
    if (twoFactorPanel) twoFactorPanel.hidden = false;
    if (twoFactorEmailDisplay) twoFactorEmailDisplay.textContent = twoFactorEmail;
    setStatus(statusEl, "", "");
    setStatus(twoFactorStatusEl, "pending", t("auth.login.two_factor.pending"));
    twoFactorOtpInput?.focus();
    if (twoFactorResendBtn && typeof cooldownSeconds === "number" && cooldownSeconds > 0) {
      startCooldownTimer(twoFactorResendBtn, cooldownSeconds);
    }
  };

  const backToLoginForm = (): void => {
    twoFactorChallengeToken = "";
    if (twoFactorPanel) twoFactorPanel.hidden = true;
    loginForm.hidden = false;
    setStatus(twoFactorStatusEl, "", "");
    passwordInput?.focus();
  };

  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const email = emailInput?.value.trim() ?? "";
      const password = passwordInput?.value ?? "";
      const rememberMe = rememberCheckbox?.checked ?? false;

      if (!email || !password) {
        setStatus(statusEl, "error", t("auth.login.validation_failed"));
        return;
      }

      setBusy(submitBtn, true, t("auth.login.submitting"), t("auth.login.submit"));
      setStatus(statusEl, "pending", t("auth.login.pending"));

      try {
        const res = await fetch("/api/auth/login", {
          body: JSON.stringify({ email, password, rememberMe }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;

        if (!res.ok) {
          if (res.status === 423) {
            setStatus(statusEl, "error", t("auth.login.account_locked"));
          } else if (res.status === 403 && data.error === "email_unverified") {
            setStatus(statusEl, "error", t("auth.login.email_unverified"));
          } else {
            setStatus(statusEl, "error", t("auth.login.invalid_credentials"));
          }
          setBusy(submitBtn, false, t("auth.login.submitting"), t("auth.login.submit"));
          return;
        }

        if (data.twoFactorRequired === true && typeof data.challengeToken === "string" && data.challengeToken.length >= 10) {
          twoFactorChallengeToken = data.challengeToken;
          twoFactorEmail = email;
          setBusy(submitBtn, false, t("auth.login.submitting"), t("auth.login.submit"));
          showTwoFactorStep(data.cooldownSeconds);
          return;
        }

        setStatus(statusEl, "success", t("auth.login.success"));
        const params = new URLSearchParams(window.location.search);
        const redirectUrl = params.get("redirect") || "/app";
        window.location.href = redirectUrl;
      } catch {
        setStatus(statusEl, "error", t("auth.login.generic_error"));
        setBusy(submitBtn, false, t("auth.login.submitting"), t("auth.login.submit"));
      }
    })();
  });

  twoFactorSubmitBtn?.addEventListener("click", () => {
    void (async () => {
      const otp = twoFactorOtpInput?.value.replace(/\D/gu, "") ?? "";
      if (otp.length !== 6 || twoFactorChallengeToken === "") {
        setStatus(twoFactorStatusEl, "error", t("auth.otp.invalid"));
        return;
      }

      setBusy(twoFactorSubmitBtn, true, t("auth.login.two_factor.submitting"), t("auth.login.two_factor.submit"));
      setStatus(twoFactorStatusEl, "pending", t("auth.login.two_factor.submitting"));

      try {
        const res = await fetch("/api/auth/login-2fa", {
          body: JSON.stringify({ challengeToken: twoFactorChallengeToken, otp }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;

        if (!res.ok) {
          const issue = Array.isArray(data.issues) ? data.issues[0] ?? "" : "";
          if (data.code === "two_factor_challenge_expired" || data.code === "challenge_token_invalid") {
            setStatus(twoFactorStatusEl, "error", t("auth.login.two_factor.expired"));
            twoFactorChallengeToken = "";
          } else if (res.status === 423) {
            setStatus(twoFactorStatusEl, "error", t("auth.login.account_locked"));
          } else if (issue.startsWith("otp_incorrect")) {
            setStatus(twoFactorStatusEl, "error", t("auth.otp.invalid"));
          } else if (issue === "otp_max_attempts_exceeded" || issue === "otp_expired_or_invalid") {
            setStatus(twoFactorStatusEl, "error", t("auth.otp.expired"));
          } else {
            setStatus(twoFactorStatusEl, "error", t("auth.login.generic_error"));
          }
          setBusy(twoFactorSubmitBtn, false, t("auth.login.two_factor.submitting"), t("auth.login.two_factor.submit"));
          return;
        }

        setStatus(twoFactorStatusEl, "success", t("auth.login.success"));
        const params = new URLSearchParams(window.location.search);
        const redirectUrl = params.get("redirect") || "/app";
        window.location.href = redirectUrl;
      } catch {
        setStatus(twoFactorStatusEl, "error", t("auth.login.generic_error"));
        setBusy(twoFactorSubmitBtn, false, t("auth.login.two_factor.submitting"), t("auth.login.two_factor.submit"));
      }
    })();
  });

  twoFactorResendBtn?.addEventListener("click", () => {
    void (async () => {
      if (twoFactorResendBtn.disabled || twoFactorEmail === "") return;

      try {
        const res = await fetch("/api/auth/otp/resend", {
          body: JSON.stringify({ email: twoFactorEmail, purpose: "login_2fa" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;
        if (res.ok && typeof data.cooldownSeconds === "number" && data.cooldownSeconds > 0) {
          startCooldownTimer(twoFactorResendBtn, data.cooldownSeconds);
          setStatus(twoFactorStatusEl, "success", t("auth.otp.resend"));
        } else if (!res.ok) {
          setStatus(twoFactorStatusEl, "error", t("auth.login.rate_limited"));
        }
      } catch {
        setStatus(twoFactorStatusEl, "error", t("auth.login.generic_error"));
      }
    })();
  });

  twoFactorBackBtn?.addEventListener("click", backToLoginForm);
}

// ----------------------------------------------------
// Setup Register Page & Wizard Step
// ----------------------------------------------------
const registerForm = document.querySelector<HTMLFormElement>("[data-register-form]");
const registerViewStep1 = document.querySelector<HTMLElement>("[data-register-view-step='1']");
const otpSection = document.querySelector<HTMLElement>("[data-otp-section]");
const regStepIndicator1 = document.querySelector<HTMLElement>("[data-step-indicator='1']");
const regStepIndicator2 = document.querySelector<HTMLElement>("[data-step-indicator='2']");
const regStepDivider = document.querySelector<HTMLElement>("[data-step-divider]");

function setWizardStep(step: 1 | 2): void {
  if (step === 1) {
    if (registerViewStep1) registerViewStep1.hidden = false;
    if (registerForm) registerForm.hidden = false;
    if (otpSection) otpSection.hidden = true;

    regStepIndicator1?.classList.add("is-active");
    regStepIndicator2?.classList.remove("is-active");
    regStepDivider?.classList.remove("is-active");
  } else {
    if (registerViewStep1) registerViewStep1.hidden = true;
    if (registerForm) registerForm.hidden = true;
    if (otpSection) otpSection.hidden = false;

    regStepIndicator1?.classList.remove("is-active");
    regStepIndicator2?.classList.add("is-active");
    regStepDivider?.classList.add("is-active");
  }
}

if (registerForm && otpSection) {
  const nameInput = registerForm.querySelector<HTMLInputElement>("[data-register-name]");
  const emailInput = registerForm.querySelector<HTMLInputElement>("[data-register-email]");
  const passwordInput = registerForm.querySelector<HTMLInputElement>("[data-register-password]");
  const confirmPasswordInput = registerForm.querySelector<HTMLInputElement>("[data-register-confirm-password]");
  const submitBtn = registerForm.querySelector<HTMLButtonElement>("[data-register-submit]");
  const statusEl = document.querySelector<HTMLElement>("[data-register-status]");

  const otpContainer = otpSection.querySelector<HTMLElement>("[data-otp-container]");
  const otpEmailDisplay = otpSection.querySelector<HTMLElement>("[data-otp-email-display]");
  const otpVerifyBtn = otpSection.querySelector<HTMLButtonElement>("[data-otp-verify-submit]");
  const otpResendBtn = otpSection.querySelector<HTMLButtonElement>("[data-otp-resend]");
  const otpStatusEl = otpSection.querySelector<HTMLElement>("[data-otp-status]");

  let userEmail = "";
  let otpController: { getOtp: () => string; reset: () => void } | null = null;

  if (otpContainer) {
    otpController = setupOtpInputs(otpContainer, (otp) => {
      if (otp.length === 6 && otpVerifyBtn) {
        otpVerifyBtn.click();
      }
    });
  }

  // Back to Step 1 buttons
  document.querySelectorAll<HTMLElement>("[data-otp-back-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setWizardStep(1);
      emailInput?.focus();
    });
  });

  registerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const displayName = nameInput?.value.trim() || undefined;
      const email = emailInput?.value.trim() ?? "";
      const password = passwordInput?.value ?? "";
      const confirmPassword = confirmPasswordInput?.value ?? "";

      if (password !== confirmPassword) {
        setStatus(statusEl, "error", t("auth.register.password_mismatch"));
        return;
      }

      if (password.length < 8) {
        setStatus(statusEl, "error", t("auth.register.password_weak"));
        return;
      }

      setBusy(submitBtn, true, t("auth.register.submitting"), t("auth.register.submit"));
      setStatus(statusEl, "pending", t("auth.register.submitting"));

      try {
        const res = await fetch("/api/auth/register", {
          body: JSON.stringify({ displayName, email, password }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;

        if (!res.ok) {
          if (res.status === 409) {
            setStatus(statusEl, "error", t("auth.register.email_exists"));
          } else {
            setStatus(statusEl, "error", data.message || t("auth.register.password_weak"));
          }
          setBusy(submitBtn, false, t("auth.register.submitting"), t("auth.register.submit"));
          return;
        }

        userEmail = email;
        if (otpEmailDisplay) otpEmailDisplay.textContent = email;

        setWizardStep(2);

        if (data.cooldownSeconds && otpResendBtn) {
          startCooldownTimer(otpResendBtn, data.cooldownSeconds);
        }

        otpController?.reset();
      } catch {
        setStatus(statusEl, "error", t("auth.login.generic_error"));
        setBusy(submitBtn, false, t("auth.register.submitting"), t("auth.register.submit"));
      }
    })();
  });

  // Verify OTP
  otpVerifyBtn?.addEventListener("click", () => {
    void (async () => {
      const otp = otpController?.getOtp() ?? "";
      if (otp.length !== 6) {
        setStatus(otpStatusEl, "error", t("auth.otp.invalid"));
        return;
      }

      setBusy(otpVerifyBtn, true, t("auth.otp.submitting"), t("auth.otp.submit"));
      setStatus(otpStatusEl, "pending", t("auth.otp.submitting"));

      try {
        const res = await fetch("/api/auth/otp/verify", {
          body: JSON.stringify({ email: userEmail, otp, purpose: "register_verify" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;

        if (!res.ok) {
          setStatus(otpStatusEl, "error", data.message || t("auth.otp.invalid"));
          setBusy(otpVerifyBtn, false, t("auth.otp.submitting"), t("auth.otp.submit"));
          return;
        }

        setStatus(otpStatusEl, "success", t("auth.login.success"));
        window.location.href = "/onboarding";
      } catch {
        setStatus(otpStatusEl, "error", t("auth.login.generic_error"));
        setBusy(otpVerifyBtn, false, t("auth.otp.submitting"), t("auth.otp.submit"));
      }
    })();
  });

  // Resend OTP
  otpResendBtn?.addEventListener("click", () => {
    void (async () => {
      if (otpResendBtn.disabled || !userEmail) return;

      try {
        const res = await fetch("/api/auth/otp/resend", {
          body: JSON.stringify({ email: userEmail, purpose: "register_verify" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;
        if (res.ok && data.cooldownSeconds) {
          startCooldownTimer(otpResendBtn, data.cooldownSeconds);
          setStatus(otpStatusEl, "success", t("auth.otp.resend"));
        }
      } catch {
        setStatus(otpStatusEl, "error", t("auth.login.generic_error"));
      }
    })();
  });
}

// ----------------------------------------------------
// Setup Forgot & Reset Password Wizard Step (3 Steps)
// ----------------------------------------------------
const forgotForm = document.querySelector<HTMLFormElement>("[data-forgot-form]");
const forgotStep1 = document.querySelector<HTMLElement>("[data-forgot-step='1']");
const forgotStep2 = document.querySelector<HTMLElement>("[data-forgot-step='2']");
const forgotStep3 = document.querySelector<HTMLElement>("[data-forgot-step='3']");

const forgotInd1 = document.querySelector<HTMLElement>("[data-forgot-indicator='1']");
const forgotInd2 = document.querySelector<HTMLElement>("[data-forgot-indicator='2']");
const forgotInd3 = document.querySelector<HTMLElement>("[data-forgot-indicator='3']");
const forgotDiv1 = document.querySelector<HTMLElement>("[data-forgot-divider='1']");
const forgotDiv2 = document.querySelector<HTMLElement>("[data-forgot-divider='2']");

function setForgotStep(step: 1 | 2 | 3): void {
  if (forgotStep1) forgotStep1.hidden = step !== 1;
  if (forgotStep2) forgotStep2.hidden = step !== 2;
  if (forgotStep3) forgotStep3.hidden = step !== 3;

  if (step === 1) {
    forgotInd1?.classList.add("is-active");
    forgotInd1?.classList.remove("is-done");
    forgotInd2?.classList.remove("is-active", "is-done");
    forgotInd3?.classList.remove("is-active", "is-done");
    forgotDiv1?.classList.remove("is-active");
    forgotDiv2?.classList.remove("is-active");
  } else if (step === 2) {
    forgotInd1?.classList.remove("is-active");
    forgotInd1?.classList.add("is-done");
    forgotInd2?.classList.add("is-active");
    forgotInd2?.classList.remove("is-done");
    forgotInd3?.classList.remove("is-active", "is-done");
    forgotDiv1?.classList.add("is-active");
    forgotDiv2?.classList.remove("is-active");
  } else {
    forgotInd1?.classList.remove("is-active");
    forgotInd1?.classList.add("is-done");
    forgotInd2?.classList.remove("is-active");
    forgotInd2?.classList.add("is-done");
    forgotInd3?.classList.add("is-active");
    forgotDiv1?.classList.add("is-active");
    forgotDiv2?.classList.add("is-active");
  }
}

if (forgotForm && (forgotStep2 || forgotStep3)) {
  const emailInput = forgotForm.querySelector<HTMLInputElement>("[data-forgot-email]");
  const submitBtn = forgotForm.querySelector<HTMLButtonElement>("[data-forgot-submit]");
  const statusEl = document.querySelector<HTMLElement>("[data-forgot-status]");

  const resetEmailDisplay = document.querySelector<HTMLElement>("[data-reset-email-display]");
  const resetOtpContainer = document.querySelector<HTMLElement>("[data-reset-otp-container]");
  const forgotOtpVerifyBtn = document.querySelector<HTMLButtonElement>("[data-forgot-otp-verify-submit]");
  const forgotOtpStatusEl = document.querySelector<HTMLElement>("[data-forgot-otp-status]");
  const resetResendBtn = document.querySelector<HTMLButtonElement>("[data-reset-resend]");

  const newPasswordInput = document.querySelector<HTMLInputElement>("[data-reset-new-password]");
  const confirmNewPasswordInput = document.querySelector<HTMLInputElement>("[data-reset-confirm-new-password]");
  const resetSubmitBtn = document.querySelector<HTMLButtonElement>("[data-reset-submit]");
  const resetStatusEl = document.querySelector<HTMLElement>("[data-reset-status]");

  let resetEmail = "";
  let verifiedResetToken = "";
  let resetOtpController: { getOtp: () => string; reset: () => void } | null = null;

  if (resetOtpContainer) {
    resetOtpController = setupOtpInputs(resetOtpContainer, (otp) => {
      if (otp.length === 6 && forgotOtpVerifyBtn) {
        forgotOtpVerifyBtn.click();
      }
    });
  }

  // Back to Step 1 buttons
  document.querySelectorAll<HTMLElement>("[data-reset-back-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setForgotStep(1);
      emailInput?.focus();
    });
  });

  // Step 1: Request Password Reset OTP
  forgotForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      const email = emailInput?.value.trim() ?? "";
      if (!email) return;

      setBusy(submitBtn, true, t("auth.forgot_password.submitting"), t("auth.forgot_password.submit"));
      setStatus(statusEl, "pending", t("auth.forgot_password.submitting"));

      try {
        const res = await fetch("/api/auth/forgot-password", {
          body: JSON.stringify({ email }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;
        resetEmail = email;
        if (resetEmailDisplay) resetEmailDisplay.textContent = email;

        setForgotStep(2);

        if (data.cooldownSeconds && resetResendBtn) {
          startCooldownTimer(resetResendBtn, data.cooldownSeconds);
        }

        resetOtpController?.reset();
      } catch {
        setStatus(statusEl, "error", t("auth.login.generic_error"));
        setBusy(submitBtn, false, t("auth.forgot_password.submitting"), t("auth.forgot_password.submit"));
      }
    })();
  });

  // Step 2: Verify OTP
  forgotOtpVerifyBtn?.addEventListener("click", () => {
    void (async () => {
      const otp = resetOtpController?.getOtp() ?? "";
      if (otp.length !== 6) {
        setStatus(forgotOtpStatusEl, "error", t("auth.otp.invalid"));
        return;
      }

      setBusy(forgotOtpVerifyBtn, true, t("auth.otp.submitting"), t("auth.otp.submit"));
      setStatus(forgotOtpStatusEl, "pending", t("auth.otp.submitting"));

      try {
        const res = await fetch("/api/auth/otp/verify", {
          body: JSON.stringify({ email: resetEmail, otp, purpose: "password_reset" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;

        if (!res.ok) {
          setStatus(forgotOtpStatusEl, "error", data.message || t("auth.otp.invalid"));
          setBusy(forgotOtpVerifyBtn, false, t("auth.otp.submitting"), t("auth.otp.submit"));
          return;
        }

        verifiedResetToken = data.resetToken ?? "";
        setForgotStep(3);
        newPasswordInput?.focus();
      } catch {
        setStatus(forgotOtpStatusEl, "error", t("auth.login.generic_error"));
        setBusy(forgotOtpVerifyBtn, false, t("auth.otp.submitting"), t("auth.otp.submit"));
      }
    })();
  });

  // Step 2: Resend OTP
  resetResendBtn?.addEventListener("click", () => {
    void (async () => {
      if (resetResendBtn.disabled || !resetEmail) return;

      try {
        const res = await fetch("/api/auth/otp/resend", {
          body: JSON.stringify({ email: resetEmail, purpose: "password_reset" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;
        if (res.ok && data.cooldownSeconds) {
          startCooldownTimer(resetResendBtn, data.cooldownSeconds);
          setStatus(forgotOtpStatusEl, "success", t("auth.otp.resend"));
        }
      } catch {
        setStatus(forgotOtpStatusEl, "error", t("auth.login.generic_error"));
      }
    })();
  });

  // Step 3: Set New Password
  resetSubmitBtn?.addEventListener("click", () => {
    void (async () => {
      const newPassword = newPasswordInput?.value ?? "";
      const confirmPassword = confirmNewPasswordInput?.value ?? "";

      if (newPassword !== confirmPassword) {
        setStatus(resetStatusEl, "error", t("auth.register.password_mismatch"));
        return;
      }

      if (newPassword.length < 8) {
        setStatus(resetStatusEl, "error", t("auth.register.password_weak"));
        return;
      }

      setBusy(resetSubmitBtn, true, t("auth.reset_password.submitting"), t("auth.reset_password.submit"));
      setStatus(resetStatusEl, "pending", t("auth.reset_password.submitting"));

      try {
        const res = await fetch("/api/auth/reset-password", {
          body: JSON.stringify({
            email: resetEmail,
            newPassword,
            resetToken: verifiedResetToken || undefined,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const data = (await res.json().catch(() => ({}))) as AuthApiResponse;

        if (!res.ok) {
          setStatus(resetStatusEl, "error", data.message || t("auth.otp.invalid"));
          setBusy(resetSubmitBtn, false, t("auth.reset_password.submitting"), t("auth.reset_password.submit"));
          return;
        }

        setStatus(resetStatusEl, "success", t("auth.reset_password.success"));
        setTimeout(() => {
          window.location.href = "/login";
        }, 1500);
      } catch {
        setStatus(resetStatusEl, "error", t("auth.login.generic_error"));
        setBusy(resetSubmitBtn, false, t("auth.reset_password.submitting"), t("auth.reset_password.submit"));
      }
    })();
  });
}
