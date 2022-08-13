let g:floaterm_width = 0.91
let g:floaterm_height = 0.98
let g:floaterm_borderchars = '─│─│╭╮╯╰'
let g:floaterm_keymap_toggle = '<F12>'

nnoremap   <silent>   <F12>   :FloatermToggle<CR>
"tnoremap   <silent>   <F12>   <C-\><C-n>:FloatermToggle<CR>

command! FloatermNewRoot FloatermNew --cwd=<root>
"
nnoremap <leader>lzg :FloatermNew lazygit<CR>
nnoremap <leader>lzn :FloatermNew lazynpm<CR>
nnoremap <leader>lzd :FloatermNew lazydocker<CR>
nnoremap <leader>n   :FloatermNew xplr .<CR>
nnoremap <leader>ff  :FloatermNew xplr %:p:h<CR>

" TODO: open files from xplr in splits:
""     \ '<c-t>': 'tab split',
""     \ '<c-x>': 'split',
""     \ '<c-v>': 'vsplit' }
