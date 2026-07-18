import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ContextStatusIndicator } from "./Thread";

describe("ContextStatusIndicator", () => {
  test("stays hidden for an unsummarized idle conversation", () => {
    const { container } = render(<ContextStatusIndicator status={{ state: "idle", estimatedTokens: null, summarized: false, jobError: null }} />);

    expect(container).toBeEmptyDOMElement();
  });

  test("shows compact running, completed, and failed states", () => {
    const { rerender } = render(<ContextStatusIndicator status={{ state: "running", estimatedTokens: null, summarized: false, jobError: null }} />);
    expect(screen.getByText("Summarizing history...")).toBeInTheDocument();

    rerender(<ContextStatusIndicator status={{ state: "idle", estimatedTokens: 42, summarized: true, jobError: null }} />);
    expect(screen.getByText("History summarized")).toBeInTheDocument();

    rerender(<ContextStatusIndicator status={{ state: "failed", estimatedTokens: null, summarized: false, jobError: "Model unavailable" }} />);
    expect(screen.getByText("Summary failed: Model unavailable")).toBeInTheDocument();
  });
});
