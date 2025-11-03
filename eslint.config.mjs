import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    ignores: ["public/qrcode.min.js"],
    rules: {
      "no-unused-vars": "off",
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
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, QRCode: "readonly" },
    },
  },
]);
