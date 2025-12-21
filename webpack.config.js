import path from 'path';
import { fileURLToPath } from 'url';
import TerserPlugin from 'terser-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  // 入口文件 - 导出 Bot 类的文件
  entry: './src/index.ts',
  
  // 输出配置
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'spbots.min.js',
    
    // 使用 AMD 模块格式
    library: {
      name: 'SPBots',
      type: 'amd',
    },
    
    // 全局对象设置
    globalObject: 'this',
  },
  
  // 解析配置
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
    extensionAlias: {
      '.js': ['.ts', '.js'],
    }
  },
  
  // 模块规则
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              // 使用项目的 tsconfig，但覆盖 module 设置
              compilerOptions: {
                module: 'esnext',
                declaration: false,
              }
            }
          }
        ],
        exclude: /node_modules/,
      },
    ],
  },
  
  // 外部依赖 - 这些不会被打包进来，而是运行时从外部获取
  externals: {
    '@chronodivide/game-api': '@chronodivide/game-api',
    'three': 'three',
    'dotenv/config': 'dotenv/config',
  },
  
  // 优化配置
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          compress: {
            drop_console: false, // 保留 console.log 用于调试
          },
          format: {
            comments: /^!|@license|@preserve/i, // 保留许可证注释
          },
        },
        extractComments: {
          condition: 'some',
          filename: (fileData) => `${fileData.filename}.LICENSE.txt`,
        },
      }),
    ],
  },
  
  // 模式
  mode: 'production',
  
  // Source map（可选，调试用）
  devtool: false, // 生产环境关闭，调试时可设为 'source-map'
};
