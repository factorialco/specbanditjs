describe('async', () => {
  test('promise resolves', async () => {
    const result = await Promise.resolve(42)
    expect(result).toBe(42)
  })
})
