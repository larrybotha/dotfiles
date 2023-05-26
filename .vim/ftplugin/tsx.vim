" We force typescript as a file everywhere because Vim added typescriptreact
" filetype, breaking detection for a whole bunch of plugins
" https://github.com/vim/vim/issues/4830
autocmd BufNewFile,BufRead *.tsx set filetype=typescript.tsx
