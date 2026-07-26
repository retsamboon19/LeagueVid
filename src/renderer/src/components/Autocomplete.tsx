import { useEffect, useRef, useState } from 'react'

export interface AutocompleteOption {
  value: string // what gets stored/searched with (e.g. champion id "MonkeyKing")
  label: string // what's displayed (e.g. "Wukong")
  iconUrl?: string | null
}

interface AutocompleteProps {
  id?: string
  value: string
  displayValue?: string
  placeholder?: string
  options: AutocompleteOption[]
  onChange: (value: string, option?: AutocompleteOption) => void
  maxSuggestions?: number
}

// Generic typeahead text input: shows a dropdown of matching suggestions as
// the user types, so free-text filters (champion names, rune names) can't
// silently fail from a typo or partial name -- the suggestion list guides
// the user to a value that will actually match.
function Autocomplete({
  id,
  value,
  displayValue,
  placeholder,
  options,
  onChange,
  maxSuggestions = 8
}: AutocompleteProps): JSX.Element {
  const [inputText, setInputText] = useState(displayValue ?? value)
  const [open, setOpen] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setInputText(displayValue ?? value)
  }, [value, displayValue])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const query = inputText.trim().toLowerCase()
  const suggestions = query
    ? options.filter((o) => o.label.toLowerCase().includes(query)).slice(0, maxSuggestions)
    : []

  function selectOption(option: AutocompleteOption): void {
    setInputText(option.label)
    onChange(option.value, option)
    setOpen(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((i) => (i - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      selectOption(suggestions[highlightIndex])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="autocomplete" ref={containerRef}>
      <input
        id={id}
        type="text"
        placeholder={placeholder}
        value={inputText}
        onChange={(e) => {
          setInputText(e.target.value)
          setHighlightIndex(0)
          setOpen(true)
          // Clear the applied filter value immediately if the text is
          // emptied, so clearing the box actually clears the filter.
          if (!e.target.value.trim()) onChange('')
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // If the text doesn't match any known option, don't silently keep
          // an invalid filter value applied -- clear it. This is what
          // prevents typos from producing a filter that matches nothing.
          if (inputText.trim() && !options.some((o) => o.label === inputText)) {
            onChange('')
          }
        }}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className="autocomplete-list">
          {suggestions.map((option, i) => (
            <li
              key={option.value}
              className={`autocomplete-item ${i === highlightIndex ? 'autocomplete-item--active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                selectOption(option)
              }}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              {option.iconUrl && <img src={option.iconUrl} alt="" className="autocomplete-item-icon" />}
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default Autocomplete
