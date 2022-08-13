" ./vimspector-global-config.json must be symlinked to:
" ~/.vim/<plugins-folder>/vimspector/configurations/macos/_all/<filename>
let g:vimspector_enable_mappings = 'HUMAN'


"| Key          | Mapping                                       | Function
"| ---          | ---                                           | ---
"| `F5`         | `<Plug>VimspectorContinue`                    | Start / continue
"| `F3`         | `<Plug>VimspectorStop`                        | Stop
"| `F4`         | `<Plug>VimspectorRestart`                     | Restart
"| `F6`         | `<Plug>VimspectorPause`                       | Pause
"| `F9`         | `<Plug>VimspectorToggleBreakpoint`            | Toggle line breakpoint
"| `<leader>F9` | `<Plug>VimspectorToggleConditionalBreakpoint` | Toggle conditional line breakpoint
"| `F8`         | `<Plug>VimspectorAddFunctionBreakpoint`       | Add a function breakpoint for the expression under cursor
"| `<leader>F8` | `<Plug>VimspectorRunToCursor`                 | Run to Cursor
"| `F10`        | `<Plug>VimspectorStepOver`                    | Step Over
"| `F11`        | `<Plug>VimspectorStepInto`                    | Step Into
"| `F12`        | `<Plug>VimspectorStepOut`                     | Step out of current function scope

" for PHP, place a .vimspect.json containing the PHP section in
" ./vimspector-global-config.json in the root of the project

" see https://www.youtube.com/watch?app=desktop&v=-AZUIL1rY3U for mapping with
" vim-test

nnoremap <leader>dw :call vimspector#AddWatch()<CR> <C-R><C-A>
nnoremap <leader>dr :call vimspector#Reset()<CR>
nnoremap <F5> :call vimspector#Continue()<CR>
nnoremap <leader>de :VimspectorEval <C-R><C-w>

" these won't work if non-recursive is applied (i.e. nnoremap)
nmap <Leader>di <Plug>VimspectorBalloonEval
xmap <Leader>di <Plug>VimspectorBalloonEval

" navigate up and down the call stack
"nnoremap <LocalLeader><F11> :call vimspector#UpFrame()<CR>
"nnoremap <LocalLeader><F12> :call vimspector#DownFrame()<CR>
