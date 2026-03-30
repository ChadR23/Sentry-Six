module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  transform: {
    '^.+\\.js$': 'babel-jest'
  },
  transformIgnorePatterns: [
    '/node_modules/'
  ],
  moduleFileExtensions: ['js', 'json'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/renderer/scripts/vendor/**',
    '!src/renderer/proto/**'
  ],
  coverageDirectory: 'coverage',
  // Mock electron globally for all tests
  moduleNameMapper: {
    '^electron$': '<rootDir>/tests/__mocks__/electron.js'
  }
};
