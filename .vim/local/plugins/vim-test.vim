let test#strategy = has('nvim') ? 'neovim' : 'vimterminal'
let g:test#preserve_screen = 1

" run Jest tests in debug mode at port 9222, running in band, so that
" debugger breakpoints are respected
let test#javascript#jest#executable = 'node --inspect=9222 node_modules/.bin/jest --runInBand --no-cache'
let g:test#javascript#jest#file_pattern = '\v(__tests__/.*|(spec|test))(.*)?\.(js|jsx|ts|tsx)$'

nmap <silent> t<C-n> :TestNearest<CR>
nmap <silent> t<C-f> :TestFile<CR>
nmap <silent> t<C-s> :TestSuite<CR>
nmap <silent> t<C-l> :TestLast<CR>
nmap <silent> t<C-g> :TestVisit<CR>
