import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders the embedded external toolbar example", () => {
  render(<App />);

  expect(screen.getByRole("button", { name: /edit document/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
});
