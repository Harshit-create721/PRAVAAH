module.exports = {
  projects: [
    {
      displayName: 'logic', testEnvironment: 'node',
      testMatch: ['<rootDir>/src/{gateway,domain}/**/*.test.ts'],
      transform: { '^.+\\.tsx?$': ['@swc/jest', { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } }] },
    },
    {
      displayName: 'ui', preset: 'jest-expo',
      testMatch: ['<rootDir>/src/ui/**/*.test.tsx'],
    },
  ],
};
