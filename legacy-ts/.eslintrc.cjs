module.exports = {
  languageOptions: {
    parser: require('@typescript-eslint/parser'),
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      project: './tsconfig.json', // 指向 tsconfig.json
    },
  },
  plugins: {
    '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
    'prettier': require('eslint-plugin-prettier'),
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    'prettier/prettier': 'error',
    // 根据项目需求添加或修改规则
  },
  env: {
    node: true,
    es2021: true,
  },
  ignorePatterns: ['node_modules/', 'dist/', '.eslintrc.cjs'],
};
