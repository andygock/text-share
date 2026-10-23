import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { ignores: ["public/qrcode.min.js"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    rules: {
      "no-unused-vars": ["error", { caughtErrors: "none" }],
      "no-empty": "off",
      curly: "error",
      "lines-around-comment": [
        "error",
        {
          beforeLineComment: true,
          allowObjectStart: true,
          allowArrayStart: true,
          allowBlockStart: true,
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ignores: ["public/**"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, QRCode: "readonly" },
    },
  },
]);
