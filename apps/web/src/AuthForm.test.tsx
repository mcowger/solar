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

mock.module("./auth", () => ({
	signIn: { email: signInEmail },
	signUp: { email: signUpEmail },
}));
mock.module("./ThemeToggle", () => ({ ThemeToggle: () => null }));

const { AuthForm } = await import("./AuthForm");

beforeEach(() => {
	signInEmail.mockClear();
	signUpEmail.mockClear();
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
});
