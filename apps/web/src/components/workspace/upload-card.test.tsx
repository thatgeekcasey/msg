import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UploadCard, uploadSize } from "./upload-card";

describe("Upload progress", () => {
  it("gives a file's size in whole KB, rounded up and at least 1, under a megabyte, and in MB to one place from there", () => {
    expect([0, 1, 999, 1_000, 1_001, 999_999, 1_000_000, 12_345_678, 250_000_000].map(uploadSize)).toEqual([
      "1 KB",
      "1 KB",
      "1 KB",
      "1 KB",
      "2 KB",
      "1000 KB",
      "1.0 MB",
      "12.3 MB",
      "250.0 MB",
    ]);
  });

  it("shows the file's name and size and how much of it has gone, then that it's being processed", () => {
    const { rerender } = render(<UploadCard upload={{ name: "moon.jpg", size: 2_500_000, percent: 42 }} />);
    const card = screen.getByRole("group", { name: "Upload moon.jpg" });
    expect(card).toHaveTextContent("moon.jpg2.5 MB");
    expect(card).not.toHaveClass("border-negative");
    expect(screen.getByRole("progressbar", { name: "Upload progress for moon.jpg" })).toHaveAttribute("value", "42");
    expect(screen.getByRole("status")).toHaveTextContent("Uploading · 42%");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(<UploadCard upload={{ name: "moon.jpg", size: 2_500_000, percent: 100 }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing…");
  });

  it("turns red and says why an upload failed, in place of its progress", () => {
    render(<UploadCard upload={{ name: "moon.jpg", size: 2_500_000, percent: 30, error: "Connection lost. Please attach the file and try again." }} />);
    expect(screen.getByRole("group", { name: "Upload moon.jpg" })).toHaveClass("border-negative");
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost. Please attach the file and try again.");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Upload failed");
  });
});
