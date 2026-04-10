describe('objects', () => {
  test('spread merge works', () => {
    const a = { x: 1 }
    const b = { y: 2 }
    expect({ ...a, ...b }).toEqual({ x: 1, y: 2 })
  })
})
