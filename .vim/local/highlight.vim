set cursorline                                 " highlight current line
set cursorcolumn                               " highlight current column

" color the cursor line and column
highlight CustomCursorConfig term=bold gui=bold ctermbg=233 guibg=black
highlight clear CursorLine
highlight clear CursorColumn
highlight link  CursorLine   CustomCursorConfig
highlight link  CursorColumn CustomCursorConfig

" make error messages more legible
highlight WarningMsg guifg=black
highlight clear Error
highlight Error ctermfg=0 ctermbg=1 guifg=black guibg=red
highlight clear ErrorMsg
highlight link ErrorMsg Error
highlight link SpellBad ErrorMsg
highlight clear NvimInternalError
highlight link NvimInternalError ErrorMsg
highlight link airline_warning_inactive_red ErrorMsg
highlight link airline_warning_red ErrorMsg

" make debugger lines more legible
highlight RedrawDebugComposed  ctermfg=0 guifg=black
highlight RedrawDebugRecompose ctermfg=0 guifg=black

" highlight trailing white space
highlight link ExtraWhitespace ErrorMsg
match ExtraWhitespace /\s\+$/
