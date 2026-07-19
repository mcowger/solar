import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

interface AuthResult {
	error: { message?: string } | null;
}

const signInEmail = mock(
	async (_credentials: {
		email: string;
		password: string;
	}): Promise<AuthResult> => ({ error: null }),
);
const signUpEmail = mock(
	async (_credentials: {
		email: string;
		password: string;
		name: string;
	}): Promise<AuthResult> => ({ error: null }),
);
const signInSocial = mock(
	async (_options: { provider: string }): Promise<AuthResult> => ({
		error: null,
	}),
);

mock.module("./auth", () => ({
	signIn: { email: signInEmail, social: signInSocial },
	signUp: { email: signUpEmail },
}));
mock.module("./ThemeToggle", () => ({ ThemeToggle: () => null }));

let googleEnabled = true;
mock.module("./authProviders", () => ({
	useGoogleAuthEnabled: () => googleEnabled,
}));

const { AuthForm } = await import("./AuthForm");

beforeEach(() => {
	signInEmail.mockClear();
	signUpEmail.mockClear();
	signInSocial.mockClear();
	googleEnabled = true;
});

describe("AuthForm", () => {
	test("submits email and password when signing in", async () => {
		const user = userEvent.setup();
		render(<AuthForm />);

		await user.type(screen.getByPlaceholderText("Email"), "person@example.com");
		await user.type(
			screen.getByPlaceholderText("Password (min 8)"),
			"password",
		);
		await user.click(screen.getByRole("button", { name: "Sign in" }));

		expect(signInEmail).toHaveBeenCalledWith({
			email: "person@example.com",
			password: "password",
		});
	});

	test("switches to registration and displays an authentication error", async () => {
		signUpEmail.mockResolvedValueOnce({
			error: { message: "Email is already registered" },
		});
		const user = userEvent.setup();
		render(<AuthForm />);

		await user.click(
			screen.getByRole("button", { name: "Need an account? Register" }),
		);
		await user.type(screen.getByPlaceholderText("Name"), "Solar User");
		await user.type(screen.getByPlaceholderText("Email"), "person@example.com");
		await user.type(
			screen.getByPlaceholderText("Password (min 8)"),
			"password",
		);
		await user.click(screen.getByRole("button", { name: "Create account" }));

		expect(signUpEmail).toHaveBeenCalledWith({
			email: "person@example.com",
			password: "password",
			name: "Solar User",
		});
		expect(
			await screen.findByText("Email is already registered"),
		).toBeInTheDocument();
	});

	test("starts Google sign-in", async () => {
		const user = userEvent.setup();
		render(<AuthForm />);

		await user.click(
			screen.getByRole("button", { name: "Continue with Google" }),
		);

		expect(signInSocial).toHaveBeenCalledWith({ provider: "google" });
	});

	test("hides the Google button when Google is not configured", () => {
		googleEnabled = false;
		render(<AuthForm />);

		expect(
			screen.queryByRole("button", { name: "Continue with Google" }),
		).not.toBeInTheDocument();
	});
});
