describe('regex', () => {
  test('matches pattern', () => {
    expect('hello123').toMatch(/^hello\d+$/)
  })
})
