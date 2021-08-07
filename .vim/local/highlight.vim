" this file needs to be sourced _before_ setting a colour scheme
" see https://gist.github.com/romainl/379904f91fa40533175dfaec4c833f2f
function! CustomHighlights() abort
  " color the cursor line and column
  " requires set cursorline columnline
  highlight CustomCursorConfig term=bold gui=bold ctermbg=233 guibg=black
  highlight clear CursorLine
  highlight clear CursorColumn
  highlight link  CursorLine   CustomCursorConfig
  highlight link  CursorColumn CustomCursorConfig

  " make error messages more legible
  highlight WarningMsg guifg=black
  highlight Error ctermfg=0 ctermbg=1 guifg=black guibg=red
  highlight clear ErrorMsg
  highlight link ErrorMsg Error
  highlight link SpellBad Error
  highlight clear NvimInternalError
  highlight link NvimInternalError Error
  highlight link airline_warning_inactive_red Error
  highlight link airline_warning_red Error

  " make debugger lines more legible
  highlight RedrawDebugComposed  ctermfg=0 guifg=black
  highlight RedrawDebugRecompose ctermfg=0 guifg=black

  " highlight trailing white space
  highlight link ExtraWhitespace Error
  match ExtraWhitespace /\s\+$/
endfunction

augroup CustomHighlights
    autocmd!
    autocmd ColorScheme * call CustomHighlights()
augroup END

