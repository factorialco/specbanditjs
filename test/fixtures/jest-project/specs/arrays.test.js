describe('arrays', () => {
  test('push adds element', () => {
    const arr = [1, 2]
    arr.push(3)
    expect(arr).toEqual([1, 2, 3])
  })
})
