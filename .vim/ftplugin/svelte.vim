" vim-svelte
let b:svelte_preprocessors = ['typescript']

" ale
let b:ale_linter_aliases = ['javascript']
let b:ale_linters = ['eslint']
" TODO: get this working with prettier_d_slim
let b:ale_fixers = ['custom_prettier_vanilla']
