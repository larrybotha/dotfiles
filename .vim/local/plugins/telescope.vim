nnoremap <C-p> :lua require'./modules/telescope'.custom_find_files()<cr>
nnoremap <leader>fg <cmd>Telescope live_grep<cr>
nnoremap <leader>fb <cmd>Telescope buffers<cr>
nnoremap <leader>fh <cmd>Telescope help_tags<cr>
nnoremap <leader>fa <cmd>Telescope builtin<cr>
nnoremap <leader>fr :lua require('telescope.builtin').lsp_references({trim_text=true})<cr>
nnoremap <leader>ft :lua require('telescope').extensions.asynctasks.all()<cr>

"" Diagnostics
" list diagnostics in workspace
nnoremap <leader>fd <cmd>Telescope diagnostics<cr>
" list diagnostics for current file only
nnoremap <leader>fD :lua require('telescope.builtin').diagnostics({bufnr=0})<cr>


highlight link TelescopeMultiSelection Identifier
highlight link TelescopeMatching Function
