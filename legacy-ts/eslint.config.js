import { FlatCompat } from '@eslint/eslintrc';
import path from 'path';
import { fileURLToPath } from 'url';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

// mimic CommonJS variables -- not needed if using CommonJS
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
    baseDirectory: __dirname,
    resolvePluginsRelativeTo: __dirname,
    recommendedConfig: js.configs.recommended,
});

export default tseslint.config(
    js.configs.recommended, // ESLint's recommended rules
    ...tseslint.configs.recommended, // TypeScript ESLint recommended rules
    prettierConfig, // Disables ESLint rules that conflict with Prettier
    {
        // Custom global ignore patterns
        ignores: ['node_modules/', 'dist/', '.eslintrc.cjs', 'eslint.config.js'],
    },
    {
        // Configuration for TypeScript files
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: __dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'warn', // Or 'error' if you prefer stricter checking
        },
    },
    {
        // Configuration for CommonJS config files like .prettierrc.cjs
        files: ['**/*.cjs'],
        languageOptions: {
            globals: {
                module: 'readonly',
                require: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
            },
        },
    },
    // Optionally, if you still need to load some parts of your .eslintrc.cjs
    // that are not covered by the above (e.g., specific plugins not easily convertible to flat config)
    // you can try to use compat.config here, but it's better to migrate fully if possible.
    // ...compat.extends('path/to/your/.eslintrc.cjs'), // This is an example, adjust as needed.
    // For now, we assume the above configurations cover the essentials.
);