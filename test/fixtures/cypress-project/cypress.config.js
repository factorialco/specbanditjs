const { defineConfig } = require('cypress')

module.exports = defineConfig({
  e2e: {
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
    // No dev server needed — these are simple assertion specs
    baseUrl: null,
    video: false,
    screenshotOnRunFailure: false,
  },
})
