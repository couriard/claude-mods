// The "Active Only" tick box, drawn in the terminal: a box, ticked or empty, and its label. A click
// anywhere on it flips it.
import type { ClientModule } from 'claude-code'

type Props = { label: string; isOn: boolean }

const ON = '#3B9C5F'

const Check: ClientModule<Props> = (props, surface) => {
  const { Box, Text } = surface.elements
  surface.onPointer(event => {
    if (event.type === 'down' && event.button === 'left') surface.post({ toggle: true })
  })
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={props.isOn ? ON : undefined} dimColor={!props.isOn}>
        {props.isOn ? '☑' : '☐'}
      </Text>
      <Text>{props.label}</Text>
    </Box>
  )
}

export default Check
