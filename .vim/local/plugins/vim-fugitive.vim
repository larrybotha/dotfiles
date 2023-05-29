" git push
nmap <leader>gp :exec ':Git push origin ' . fugitive#head()<CR>

" git status
map <silent> <leader>gs :Git<CR>

" git commit -am "
map <leader>gci :Git commit -am "

" git checkout
map <leader>gco :Git checkout<space>

" git diff
map <leader>gd :Gdiff<CR>
