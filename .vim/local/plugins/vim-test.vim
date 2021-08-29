let test#strategy = has('nvim') ? 'neovim' : "vimterminal"
let g:test#preserve_screen = 1
" run Jest tests in debug mode at port 9222, running in band, so that
" debugger breakpoints are respected
let test#javascript#jest#executable = 'node --inspect=9222 $(npm bin)/jest --runInBand --no-cache'
let g:test#javascript#jest#file_pattern = '\v(__tests__/.*|(spec|test))(.*)?\.(js|jsx|ts|tsx)$'

nmap <silent> t<C-n> :TestNearest<CR> " t Ctrl+n
nmap <silent> t<C-f> :TestFile<CR>    " t Ctrl+f
nmap <silent> t<C-s> :TestSuite<CR>   " t Ctrl+s
nmap <silent> t<C-l> :TestLast<CR>    " t Ctrl+l
nmap <silent> t<C-g> :TestVisit<CR>   " t Ctrl+g
