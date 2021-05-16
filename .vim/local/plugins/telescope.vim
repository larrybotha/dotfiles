nnoremap <C-p> :lua require'modules/telescope'.custom_find_files()<cr>
nnoremap <leader>fg <cmd>Telescope live_grep<cr>
nnoremap <leader>fb <cmd>Telescope buffers<cr>
nnoremap <leader>fh <cmd>Telescope help_tags<cr>
nnoremap <leader>fa <cmd>Telescope builtin<cr>
nnoremap <leader>fd <cmd>Telescope lsp_document_diagnostics<cr>
" TODO: determine how to show filenames insstead of code in picker
"nnoremap <leader>fr <cmd>Telescope lsp_references<cr>

highlight link TelescopeMultiSelection Identifier
highlight link TelescopeMatching Function
