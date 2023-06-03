" Modeline and Notes {
" vim: set foldmarker={,} foldlevel=0 foldmethod=marker spell:
"  This .vimrc is largely inspired by
"  https://github.com/spf13/spf13-vim/blob/master/.vimrc and
"  https://github.com/kmckelvin/vimrc/blob/master/vimrc
" }

" Environment {
  " Basics {
    set background=dark " assume a dark background
  "}
"}

" Plugin Installation {
  " install Plug if it isn't already
  if empty(glob('~/.vim/autoload/plug.vim'))
    silent !curl -fLo ~/.vim/autoload/plug.vim --create-dirs
      \ https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim

    augroup au_source
      au!
      autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
    augroup END
  endif

  " conditionally get options
  function! Cond(cond, ...)
    let opts = get(a:000, 0, {})
    return a:cond ? opts : extend(opts, { 'on': [], 'for': [] })
  endfunction

  call plug#begin('~/.vim/plugged')

  "Plug 'wakatime/vim-wakatime'

  " Themes
  Plug 'mellow-theme/mellow.nvim'

  "Plug 'skywind3000/asynctasks.vim'
  "Plug 'skywind3000/asyncrun.vim'
  "Plug 'voldikss/vim-floaterm'

  "Plug 'junegunn/fzf', { 'dir': '~/.fzf', 'do': './install --all' }
  "Plug 'junegunn/fzf.vim'

  "Plug 'tpope/vim-sensible'
  "Plug 'tpope/vim-fugitive'
  "Plug 'tpope/vim-surround'
  "Plug 'tpope/vim-endwise'

  Plug 'Raimondi/delimitMate'
  Plug 'christoomey/vim-tmux-navigator'
  Plug 'editorconfig/editorconfig-vim'
  Plug 'mcchrish/nnn.vim'
  Plug 'godlygeek/tabular'
  Plug 'preservim/nerdcommenter'
  Plug 'rhysd/git-messenger.vim'
  Plug 'mg979/vim-visual-multi'
  Plug 'nvim-lualine/lualine.nvim'
  Plug 'janko-m/vim-test'
  Plug 'danymat/neogen'
  Plug 'ruanyl/vim-sort-imports'
  Plug 'dkarter/bullets.vim'
  Plug 'preservim/vimux'

  " Language support
  "Plug 'sheerun/vim-polyglot'
  "Plug 'simrat39/rust-tools.nvim'
  "Plug 'evanleck/vim-svelte', {'branch': 'main'}
  "Plug 'mattn/emmet-vim'
  "Plug 'fatih/vim-go', {'do': ':GoInstallBinaries'}

  " only load if we are in Neovim
  Plug 'folke/neodev.nvim', Cond(has('nvim'))
  Plug 'folke/trouble.nvim', Cond(has('nvim'))
  Plug 'nvimtools/none-ls.nvim', Cond(has('nvim'))
  Plug 'mhartington/formatter.nvim', Cond(has('nvim'))
  Plug 'jodosha/vim-godebug', Cond(has('nvim'))
  Plug 'williamboman/mason.nvim', Cond(has('nvim'))
  Plug 'williamboman/mason-lspconfig.nvim', Cond(has('nvim'))
  Plug 'neovim/nvim-lspconfig', Cond(has('nvim'))
  Plug 'nvim-treesitter/nvim-treesitter', Cond(has('nvim'), {'do': ':TSUpdate'})
  Plug 'nvim-treesitter/nvim-treesitter-context'

  Plug 'ojroques/nvim-lspfuzzy', Cond(has('nvim'))

  " debugging
  Plug 'mfussenegger/nvim-dap', Cond(has('nvim'))
  Plug 'rcarriga/nvim-dap-ui', Cond(has('nvim'))
  Plug 'nvim-neotest/nvim-nio', Cond(has('nvim')) " nvim-dap-ui dependency

  " completion
  Plug 'hrsh7th/cmp-nvim-lsp'
  Plug 'hrsh7th/cmp-buffer'
  Plug 'hrsh7th/cmp-path'
  Plug 'hrsh7th/cmp-cmdline'
  Plug 'hrsh7th/cmp-nvim-lsp-signature-help'
  Plug 'hrsh7th/nvim-cmp'
  Plug 'hrsh7th/vim-vsnip'

  " telescope and deps
  if has('nvim')
    Plug 'nvim-lua/popup.nvim'
    Plug 'nvim-lua/plenary.nvim'
    Plug 'nvim-telescope/telescope.nvim'
    Plug 'nvim-telescope/telescope-fzf-native.nvim', { 'do': 'cmake -S. -Bbuild -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release && cmake --install build --prefix build' }
    Plug 'kyazdani42/nvim-web-devicons'
    Plug 'GustavoKatel/telescope-asynctasks.nvim'
    Plug 'lukas-reineke/indent-blankline.nvim'
    Plug 'lewis6991/gitsigns.nvim'
    Plug 'epwalsh/obsidian.nvim'
    Plug 'ThePrimeagen/harpoon', {'branch': 'harpoon2'}

    " AI tools
    "Plug 'Exafunction/codeium.vim'
  end

  call plug#end()
"}

" General {
  filetype plugin indent on " automatically detect files types
  syntax on                 " syntax highlighting
  set mouse=a               " automatically enable mouse usage
  scriptencoding utf-8
  set history=1000          " store more history (default is 20)
  set nospell               " spell checking off
  set noswapfile            " don't use swapfiles

  " don't create backup files
  set nobackup
  set nowritebackup

  if !has('nvim')
    " remove the delay when hitting esc in insert mode
    set noesckeys
  endif

  set ttimeout
  set ttimeoutlen=1

  set showbreak=↪

  set fillchars=diff:·

  " use ripgrep for :grep and populating quickfix list
  if executable('rg')
    set grepprg=rg\ --vimgrep\ --hidden\ --smart-case
    " `%f` represents the file name where the match was found
    " `%l` represents the line number where the match was found
    " `%c` represents the column number where the match was found
    " `%m` represents the matched text itself
    set grepformat^=%f:%l:%c:%m

    augroup au_open_quick_fix
      autocmd QuickFixCmdPost grep copen
    augroup END
  endif

  " run checktime to reload file if changed
  augroup au_checktime
    au!
    autocmd FocusGained,BufEnter * silent! checktime

    " when cursor stops moving
    " https://vi.stackexchange.com/questions/14315/how-can-i-tell-if-im-in-the-command-window
    autocmd CursorHold,CursorHoldI *
      \ if mode() == 'n' && getcmdwintype() == '' | checktime | endif
  augroup END

  set autoread

  if has('mouse_sgr')
    set ttymouse=sgr
  endif
" }

" Vim UI {
  source ~/.vim/local/highlight.vim
  colorscheme mellow             " load a colourscheme
  set termguicolors              " use gui color attributes instead of cterm attributes
  set splitright                 " open split panes to the right of the current pane
  set splitbelow                 " open split panes underneath the current pane

  set backspace=indent,eol,start " allow backspacing over everything in insert mode
  set linespace=0                " No extra spaces between rows
  set number relativenumber      " use hybrid line numbers
  set showmatch                  " show matching brackets/parenthesis
  set incsearch                  " find as you type search
  set hlsearch                   " highlight search terms
  set winminheight=0             " windows can be 0 line high
  set ignorecase                 " case insensitive search
  set smartcase                  " case sensitive when uc present
  set wildmenu                   " show list instead of just completing
  set wildmode=list:longest,full " command <Tab> completion, list matches, then longest common part, then all.
  set nowrap                     " don't wrap lines
  set scrolljump=5               " lines to scroll when cursor leaves screen
  set scrolloff=5                " minimum lines to keep above and below cursor
  nohlsearch                     " clear the initial highlight after sourcing
  set foldenable                 " auto fold code
  set nospell                    " disable spellcheck
  set shortmess=atI              " prevent 'Press ENTER' prompt
  set cursorline                 " highlight current line
  set cursorcolumn               " highlight current column
  set colorcolumn=85             " show column length hint for long lines
  set showcmd                    " show timeout on leader
" }

" Formatting {
  set autoindent                                          " indent at the same level of the previous line
  set shiftwidth=2                                        " use indents of 2 spaces
  set tabstop=2                                           " indent every 2 columns
  set softtabstop=2                                       " let backspace delete indent
  set expandtab

  augroup au_set_space
    au!
    autocmd BufNewFile,BufReadPost * set ai ts=2 sw=2 sts=2 " set above values when opening new files
  augroup END
" }

" Key Mappings {
  " set custom leader
  let mapleader = ','

  " j and k navigate through wrapped lines
  nmap k gk
  nmap j gj

  " yank from cursor to EOL the same as C and D do
  nnoremap Y y$

  " code folding options
  nmap <leader>f0 :set foldlevel=0<CR>
  nmap <leader>f1 :set foldlevel=1<CR>
  nmap <leader>f2 :set foldlevel=2<CR>
  nmap <leader>f3 :set foldlevel=3<CR>
  nmap <leader>f4 :set foldlevel=4<CR>
  nmap <leader>f5 :set foldlevel=5<CR>
  nmap <leader>f6 :set foldlevel=6<CR>
  nmap <leader>f7 :set foldlevel=7<CR>
  nmap <leader>f8 :set foldlevel=8<CR>
  nmap <leader>f9 :set foldlevel=9<CR>

  " clear highlighted searches
  nnoremap <silent> <leader>/ :nohlsearch<CR>

  " navigate using [ and ]
  noremap [b :bprevious<CR>
  noremap ]b :bnext<CR>
  noremap [q :cprevious<CR>
  noremap ]q :cnext<CR>
  noremap [l :lprevious<CR>
  noremap ]l :lnext<CR>

  " visual shifting without exiting visual mode
  vnoremap < <gv
  vnoremap > >gv

  " quickly move lines up and down with <A-J> == ∆ and <A-K> == ˚
  nnoremap ∆ :m .+1<CR>==
  nnoremap ˚ :m .-2<CR>==
  inoremap ∆ <Esc>:m .+1<CR>==gi
  inoremap ˚ <Esc>:m .-2<CR>==gi
  vnoremap ∆ :m '>+1<CR>gv=gv
  vnoremap ˚ :m '<-2<CR>gv=gv

  " paste, fix indentation and clear the mark by default
  nnoremap p p=`]`<esc>

  " quickly move to next and previous buffers
  map <leader>bn :bn<CR>
  map <leader>bp :bp<CR>

  " quick access to this .vimrc
  map <leader>vi :tabedit ~/projects/dotfiles/.vimrc<CR>
  map <leader>vs :source $MYVIMRC<CR>

  " set all windows to equal width
  map <leader>= <C-w>=
" }

" Auto Commands {

  if has('autocmd')
    " Also load indent files, to automatically do language-dependent indenting.
    augroup au_vimrcEx
      autocmd!

      " For all text files set 'textwidth' to 80 characters.
      autocmd BufRead *.txt,*.md,*.svx,*.textile set textwidth=80

      " Set .svx files as markdown
      " TODO: move to filetype plugin
      autocmd BufRead *.svx set ft=markdown

      " Delete trailing white space on save
      autocmd BufWritePre * :%s/\s\+$//e

      " When editing a file, always jump to the last known cursor position.
      " Don't do it when the position is invalid or when inside an event handler
      " (happens when dropping a file on gvim).
      autocmd BufReadPost *
        \ if line("'\"") > 0 && line("'\"") <= line("$") |
        \  exe "normal g`\"" |
        \ endif
    augroup END

    " Use hybrid line numbers when in any mode other than 'insert' mode,
    " otherwise use 'number'
    augroup au_numbertoggle
      autocmd!

      autocmd BufEnter,FocusGained,InsertLeave,WinEnter *
        \ if &number && mode() != "i"
        \ | set relativenumber | endif
      autocmd BufLeave,FocusLost,InsertEnter,WinLeave *
        \ if &number
        \ | set norelativenumber | endif
    augroup END
  endif " has("autocmd")

" }

" Plugin Configs {
 "source ~/.vim/local/neovim.vim

  source ~/.vim/local/plugins/vim-plug.vim
  source ~/.vim/local/plugins/asynctasks.vim
  source ~/.vim/local/plugins/cmp.vim
  source ~/.vim/local/plugins/codeium.vim
  source ~/.vim/local/plugins/delimit-mate.vim
  source ~/.vim/local/plugins/editorconfig-vim.vim
  source ~/.vim/local/plugins/emmet-vim.vim
  source ~/.vim/local/plugins/endwise.vim
  source ~/.vim/local/plugins/floaterm.vim
  source ~/.vim/local/plugins/fzf.vim
  source ~/.vim/local/plugins/nerdcommenter.vim
  source ~/.vim/local/plugins/nnn.vim
  source ~/.vim/local/plugins/tabular.vim
  source ~/.vim/local/plugins/telescope.vim
  source ~/.vim/local/plugins/vim-fugitive.vim
  source ~/.vim/local/plugins/vim-go.vim
  source ~/.vim/local/plugins/vim-sort-imports.vim
  source ~/.vim/local/plugins/vim-svelte.vim
  source ~/.vim/local/plugins/vim-test.vim
  source ~/.vim/local/plugins/vim-tmux-navigator.vim
  source ~/.vim/local/plugins/vimux.vim
" }
