// One skill, gate or connector as a card, drawn in the terminal: the name at the top,
// its description in grey on up to two lines, and the on/off switch inside the card at the bottom
// right. A click on the switch flips it; a click anywhere else on the card does nothing, so a
// card can be read without changing anything by accident.
import type { ClientModule } from 'claude-code'

type Props = { name: string; version: string; description: string; tag: string; isOn: boolean; isBusy: boolean; canSwitch?: boolean }

const ON = '#3B9C5F'
const OFF = '#5a5a58'
const KNOB = '#ffffff'
const EDGE = '#3a3a38'
// The switch's width in cells: a rounded end, five cells of body, the other rounded end.
const SWITCH_W = 7

// Cuts a description to two lines of the card's width, by words, with an ellipsis when it had to.
const twoLines = (text: string, width: number): string => {
  const room = Math.max(10, width) * 2
  if (text.length <= room) return text
  const cut = text.slice(0, room - 1)
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), room - 12)).trimEnd() + '…'
}

const Card: ClientModule<Props> = (props, surface) => {
  const { Box, Text } = surface.elements
  // The switch sits on the card's last inside row, at its right, inside the border and padding.
  surface.onPointer(event => {
    if (event.type !== 'down' || event.button !== 'left' || props.isBusy || props.canSwitch === false) return
    const isOnSwitchRow = surface.rows === 0 || event.y >= surface.rows - 3
    const isOnSwitchColumns = surface.columns === 0 || event.x >= surface.columns - 3 - SWITCH_W
    if (isOnSwitchRow && isOnSwitchColumns) surface.post({ toggle: true })
  })
  const fill = props.isOn ? ON : OFF
  const inner = Math.max(10, surface.columns - 4)
  return (
    <Box borderStyle="round" borderColor={EDGE} paddingX={1} flexDirection="column" width="100%">
      <Box flexDirection="row" gap={1}>
        <Text bold dimColor={!props.isOn}>
          {props.name}
        </Text>
        {props.version ? <Text dimColor>{props.version}</Text> : null}
        {props.tag ? <Text dimColor>· {props.tag}</Text> : null}
      </Box>
      <Text dimColor wrap="wrap">
        {twoLines(props.description || 'No description in its file.', inner)}
      </Text>
      {props.canSwitch === false ? null : (
      <Box flexDirection="row" justifyContent="flex-end">
        <Text color={fill}>◖</Text>
        <Text backgroundColor={fill} color={KNOB}>
          {props.isBusy ? ' ··· ' : props.isOn ? '    ●' : '●    '}
        </Text>
        <Text color={fill}>◗</Text>
      </Box>
      )}
    </Box>
  )
}

export default Card
