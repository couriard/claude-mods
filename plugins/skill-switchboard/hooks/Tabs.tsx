// The tabs switcher, drawn in the terminal: one rounded pill split into parts, the chosen one
// lit. A click on any part chooses it.
import type { ClientModule } from 'claude-code'

type Props = { options: { value: string; label: string }[]; value: string }

const LIT = '#ececec'
const INK = '#1f1f1e'
const EDGE = '#3a3a38'

const Tabs: ClientModule<Props> = (props, surface) => {
  const { Box, Text } = surface.elements
  // Each half is its label with two cells of room either side; the divider takes one cell.
  const widths = props.options.map(o => o.label.length + 4)
  surface.onPointer(event => {
    if (event.type !== 'down' || event.button !== 'left') return
    // Inside the left border (one cell), walk the halves and their dividers.
    let x = event.x - 1
    for (let i = 0; i < props.options.length; i++) {
      const w = widths[i] ?? 0
      if (x < w) {
        const option = props.options[i]
        if (option && option.value !== props.value) surface.post({ tab: option.value })
        return
      }
      x -= w + 1
    }
  })
  return (
    <Box borderStyle="round" borderColor={EDGE} flexDirection="row">
      {props.options.map((o, i) => {
        const isLit = o.value === props.value
        return (
          <Box key={o.value} flexDirection="row">
            {i > 0 ? <Text color={EDGE}>│</Text> : null}
            <Text bold={isLit} dimColor={!isLit} backgroundColor={isLit ? LIT : undefined} color={isLit ? INK : undefined}>
              {`  ${o.label}  `}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export default Tabs
