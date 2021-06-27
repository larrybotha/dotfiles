" Start n³
nnoremap <silent> <leader>n :NnnPicker<CR>
" Start n³ in the current file's directory
nnoremap <leader>ff :NnnPicker %:p:h<CR>

" start n³ showing hidden files
let g:nnn#command = 'nnn -H'

" Floating window
let g:nnn#layout = { 'window': { 'width': 0.9, 'height': 0.6, 'highlight': 'Debug' } }

let g:nnn#action = {
\ '<c-t>': 'tab split',
\ '<c-x>': 'split',
\ '<c-v>': 'vsplit' }
