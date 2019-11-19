" always set filetype to typescript.tsx
"
" Vim added typescriptreact filetype, breaking filetype detection in Tsuquyomi:
" https://github.com/vim/vim/issues/4830
autocmd BufNewFile,BufRead *.tsx set filetype=typescript
