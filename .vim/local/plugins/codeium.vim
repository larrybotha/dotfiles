" Codeium needs to be authenticated using :Codeium Auth

" disable Codeium's tab key mapping
let g:codeium_no_map_tab = 0

inoremap <script><silent><nowait><expr> <C-g><C-g> codeium#Accept()
inoremap <expr> <C-g><C-n> codeium#CycleCompletions(1)<CR>
inoremap <expr> <C-g><C-p> codeium#CycleCompletions(-1)<CR>
inoremap <expr> <C-g><C-c> codeium#Clear()<CR>
