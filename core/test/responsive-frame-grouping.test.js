import assert from 'node:assert/strict'
import test from 'node:test'
import { groupResponsiveFrames } from '../../shared/responsive-frame-grouping.js'

const frame = (id, name, width, selectionIndex) => ({ id, name, type: 'FRAME', width, height: 900, selectionIndex })

test('groups multiple responsive pairs and single Frames in stable selection order', () => {
  const groups = groupResponsiveFrames([
    frame('product-mobile', '产品页-移动端', 390, 3),
    frame('home', '首页', 1440, 0),
    frame('about', '关于页', 390, 4),
    frame('product', '产品页', 1440, 2),
    frame('home-mobile', '首页-移动端', 375, 1),
  ])
  assert.deepEqual(groups.map((group) => [group.kind, group.name]), [
    ['responsive-page', '首页'],
    ['responsive-page', '产品页'],
    ['single-page', '关于页'],
  ])
  assert.deepEqual(groups[0].frames.map((item) => item.id), ['home', 'home-mobile'])
})

test('rejects orphan, duplicate, invalid-size, and non-Frame selections', () => {
  assert.throws(() => groupResponsiveFrames([frame('mobile', '首页-移动端', 375, 0)]), /缺少同名桌面端/)
  assert.throws(() => groupResponsiveFrames([
    frame('home-1', '首页', 1440, 0),
    frame('home-2', '首页', 1440, 1),
    frame('mobile', '首页-移动端', 375, 2),
  ]), /重复 Frame 名称/)
  assert.throws(() => groupResponsiveFrames([
    frame('home', '首页', 800, 0),
    frame('mobile', '首页-移动端', 768, 1),
  ]), /尺寸不满足规则/)
  assert.throws(() => groupResponsiveFrames([{ ...frame('group', 'Group', 1440, 0), type: 'GROUP' }]), /只支持有名称的可见顶层 Frame/)
})

test('keeps duplicate ordinary page names independent when no responsive pair exists', () => {
  const groups = groupResponsiveFrames([
    frame('news-1', '资讯', 1440, 0),
    frame('news-2', '资讯', 1440, 1),
  ])
  assert.deepEqual(groups.map((group) => group.kind), ['single-page', 'single-page'])
})

test('disabling pairing keeps App target Frames as independent pages', () => {
  const groups = groupResponsiveFrames([
    frame('home', '首页', 1440, 0),
    frame('mobile', '首页-移动端', 375, 1),
  ], { pairingEnabled: false })
  assert.deepEqual(groups.map((group) => group.kind), ['single-page', 'single-page'])
})
