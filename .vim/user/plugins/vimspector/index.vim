" ./vimspector-global-config.json must be symlinked to:
" ~/.vim/<plugins-folder>/vimspector/configurations/macos/_all/<filename>
let g:vimspector_enable_mappings = 'HUMAN'

" for PHP, place a .vimspect.json containing the PHP section in
" ./vimspector-global-config.json in the root of the project

" see https://www.youtube.com/watch?app=desktop&v=-AZUIL1rY3U for mapping with
" vim-test

nnoremap <leader>dw :call vimspector#AddWatch()
nnoremap <leader>dr :call vimspector#Reset()<CR>
nnoremap <F5> :call vimspector#Continue()<CR>

" doesn't appear to work
nnoremap <Leader>di <Plug>VimspectorBalloonEval
xnoremap <Leader>di <Plug>VimspectorBalloonEval
