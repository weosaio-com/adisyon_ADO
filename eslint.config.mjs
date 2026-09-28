// Flat ESLint config (monorepo koku). Bicimlendirme prettier'da; burada dogruluk odakli
// hafif kurallar. Tur-kontrollu (type-checked) kurallar CI hizini dusurmemek icin kapali.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      'apps/desktop/bundle/**',
      '**/.prisma/**',
      '**/generated/**',
      '**/.wrangler/**',
      'packages/shared/dist/**',
      'apps/backend/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Kullanilmayan degiskenler uyari (bloklamaz); _ onekli kasitli olanlar muaf.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  prettier,
);
